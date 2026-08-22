import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
    GetPromptResult,
    ListPromptsResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    PromptMessage,
    ReadResourceResult,
    Resource,
    ResourceTemplate,
} from '@modelcontextprotocol/sdk/types.js';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    McpAnnotations as PluginMcpAnnotations,
    McpClient as PluginMcpClient,
    McpGetPromptResult as PluginMcpGetPromptResult,
    McpIcon as PluginMcpIcon,
    McpPrompt as PluginMcpPrompt,
    McpPromptContent as PluginMcpPromptContent,
    McpPromptPage as PluginMcpPromptPage,
    McpReadResourceResult as PluginMcpReadResourceResult,
    McpResource as PluginMcpResource,
    McpResourcePage as PluginMcpResourcePage,
    McpResourceTemplate as PluginMcpResourceTemplate,
    McpResourceTemplatePage as PluginMcpResourceTemplatePage,
    McpTool as PluginMcpTool,
} from '@happier-dev/plugin-sdk/mcp';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginInteractionsService } from './interactions';
import {
    mcpElicitationFormContent,
    mcpElicitationFormQuestions,
} from './mcpElicitationForm';
import type { DeclaredTransportConnector } from './mcp';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

type ResolvedMcpExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release?: () => void;
}>;

type McpResourceSubscriptionRecord = {
    readonly uri: string;
    readonly listener: (event: Readonly<{ uri: string }>) => void | Promise<void>;
    chain: Promise<void>;
    disposed: boolean;
    disposePromise: Promise<void> | null;
    dispose(): Promise<void>;
};

function toJsonValue(value: unknown): JsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new PluginError({ code: 'plugin_mcp_result_invalid', message: 'MCP result is not JSON serializable' });
    }
    return JSON.parse(encoded) as JsonValue;
}

function optionalJson(value: unknown): JsonValue | undefined {
    return value === undefined ? undefined : toJsonValue(value);
}

function projectAnnotations(value: Resource['annotations']): PluginMcpAnnotations | undefined {
    if (value === undefined) return undefined;
    return Object.freeze({
        ...(value.audience === undefined ? {} : { audience: Object.freeze([...value.audience]) }),
        ...(value.priority === undefined ? {} : { priority: value.priority }),
        ...(value.lastModified === undefined ? {} : { lastModified: value.lastModified }),
    });
}

function projectIcons(value: Resource['icons']): readonly PluginMcpIcon[] | undefined {
    return value === undefined ? undefined : Object.freeze(value.map((icon) => Object.freeze({
        src: icon.src,
        ...(icon.mimeType === undefined ? {} : { mimeType: icon.mimeType }),
        ...(icon.sizes === undefined ? {} : { sizes: Object.freeze([...icon.sizes]) }),
        ...(icon.theme === undefined ? {} : { theme: icon.theme }),
    })));
}

function projectResource(value: Resource): PluginMcpResource {
    const meta = optionalJson(value._meta);
    const annotations = projectAnnotations(value.annotations);
    const icons = projectIcons(value.icons);
    return Object.freeze({
        uri: value.uri,
        name: value.name,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
        ...(annotations === undefined ? {} : { annotations }),
        ...(icons === undefined ? {} : { icons }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectResourceTemplate(value: ResourceTemplate): PluginMcpResourceTemplate {
    const meta = optionalJson(value._meta);
    const annotations = projectAnnotations(value.annotations);
    const icons = projectIcons(value.icons);
    return Object.freeze({
        uriTemplate: value.uriTemplate,
        name: value.name,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
        ...(annotations === undefined ? {} : { annotations }),
        ...(icons === undefined ? {} : { icons }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectResourceContents(value: ReadResourceResult['contents'][number]): PluginMcpReadResourceResult['contents'][number] {
    const meta = optionalJson(value._meta);
    const common = {
        uri: value.uri,
        ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
        ...(meta === undefined ? {} : { _meta: meta }),
    };
    return 'text' in value
        ? Object.freeze({ ...common, text: value.text })
        : Object.freeze({ ...common, blob: value.blob });
}

function projectResourcePage(value: ListResourcesResult): PluginMcpResourcePage {
    const meta = optionalJson(value._meta);
    return Object.freeze({
        items: Object.freeze(value.resources.map(projectResource)),
        ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectResourceTemplatePage(value: ListResourceTemplatesResult): PluginMcpResourceTemplatePage {
    const meta = optionalJson(value._meta);
    return Object.freeze({
        items: Object.freeze(value.resourceTemplates.map(projectResourceTemplate)),
        ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectReadResourceResult(value: ReadResourceResult): PluginMcpReadResourceResult {
    const meta = optionalJson(value._meta);
    return Object.freeze({
        contents: Object.freeze(value.contents.map(projectResourceContents)),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectPrompt(value: ListPromptsResult['prompts'][number]): PluginMcpPrompt {
    const meta = optionalJson(value._meta);
    const icons = projectIcons(value.icons);
    return Object.freeze({
        name: value.name,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.arguments === undefined ? {} : {
            arguments: Object.freeze(value.arguments.map((argument) => Object.freeze({
                name: argument.name,
                ...(argument.description === undefined ? {} : { description: argument.description }),
                ...(argument.required === undefined ? {} : { required: argument.required }),
            }))),
        }),
        ...(icons === undefined ? {} : { icons }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectPromptContent(value: PromptMessage['content']): PluginMcpPromptContent {
    if (value.type === 'resource_link') {
        return Object.freeze({ type: 'resource_link', ...projectResource(value) });
    }
    const meta = optionalJson(value._meta);
    const annotations = projectAnnotations(value.annotations);
    if (value.type === 'text') {
        return Object.freeze({
            type: 'text', text: value.text,
            ...(annotations === undefined ? {} : { annotations }),
            ...(meta === undefined ? {} : { _meta: meta }),
        });
    }
    if (value.type === 'image' || value.type === 'audio') {
        return Object.freeze({
            type: value.type, data: value.data, mimeType: value.mimeType,
            ...(annotations === undefined ? {} : { annotations }),
            ...(meta === undefined ? {} : { _meta: meta }),
        });
    }
    return Object.freeze({
        type: 'resource', resource: projectResourceContents(value.resource),
        ...(annotations === undefined ? {} : { annotations }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectPromptPage(value: ListPromptsResult): PluginMcpPromptPage {
    const meta = optionalJson(value._meta);
    return Object.freeze({
        items: Object.freeze(value.prompts.map(projectPrompt)),
        ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function projectGetPromptResult(value: GetPromptResult): PluginMcpGetPromptResult {
    const meta = optionalJson(value._meta);
    return Object.freeze({
        ...(value.description === undefined ? {} : { description: value.description }),
        messages: Object.freeze(value.messages.map((message) => Object.freeze({
            role: message.role,
            content: projectPromptContent(message.content),
        }))),
        ...(meta === undefined ? {} : { _meta: meta }),
    });
}

function composeSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
    const distinct = [...new Set(signals.filter((value): value is AbortSignal => value !== undefined))];
    if (distinct.length === 0) return undefined;
    if (distinct.length === 1) return distinct[0];
    return AbortSignal.any(distinct);
}

export function createStableDeclaredMcpTransportConnector(params?: Readonly<{
    resolveExecutable(
        executable: ManagedExecutableRef,
        pluginId: string,
    ): Promise<ResolvedMcpExecutable>;
}>): DeclaredTransportConnector {
    return async ({ declaration, elicitation, seed, signal }): Promise<PluginMcpClient> => {
        if (declaration.definition.kind !== 'static') {
            throw new PluginError({ code: 'plugin_mcp_transport_unavailable', message: 'Declared MCP transport is unavailable' });
        }
        const transportDefinition = declaration.definition.transport;
        let releaseExecutable: (() => void) | null = null;
        const release = () => {
            const current = releaseExecutable;
            releaseExecutable = null;
            current?.();
        };
        const transport = await (async () => {
            if (transportDefinition.kind === 'http') {
                return new StreamableHTTPClientTransport(new URL(transportDefinition.url));
            }
            if (transportDefinition.kind !== 'stdio' || !params?.resolveExecutable || !declaration.pluginId) {
                throw new PluginError({ code: 'plugin_mcp_transport_unavailable', message: 'Declared MCP transport is unavailable' });
            }
            const executable = await params.resolveExecutable(
                transportDefinition.executable,
                declaration.pluginId,
            );
            releaseExecutable = executable.release ?? null;
            return new StdioClientTransport({
                command: executable.command,
                args: [...(executable.args ?? []), ...(transportDefinition.args ?? [])],
                ...(executable.env === undefined ? {} : { env: { ...executable.env } }),
            });
        })();
        const lifetimeSignal = composeSignals(seed.signal, signal);
        const client = new Client(
            { name: 'happier-plugin-mcp', version: '1.0.0' },
            { capabilities: elicitation.mode === 'hostMediated' ? { elicitation: { form: {} } } : {} },
        );
        const subscriptions = new Set<McpResourceSubscriptionRecord>();
        client.onclose = () => {
            for (const subscription of subscriptions) {
                subscription.disposed = true;
                subscription.disposePromise ??= Promise.resolve();
            }
            subscriptions.clear();
        };
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
            await Promise.all([...subscriptions].flatMap((subscription) => {
                if (subscription.disposed || subscription.uri !== notification.params.uri) return [];
                subscription.chain = subscription.chain.then(async () => {
                    if (!subscription.disposed) {
                        await subscription.listener(Object.freeze({ uri: notification.params.uri }));
                    }
                }).catch(() => {
                    process.emitWarning('MCP resource subscription listener failed', {
                        code: 'HAPPIER_MCP_RESOURCE_LISTENER_FAILED',
                    });
                });
                return [subscription.chain];
            }));
        });
        if (elicitation.mode === 'hostMediated') {
            const interactions = createPluginInteractionsService({
                currentSession: seed.currentSession ?? null,
                signal: lifetimeSignal ?? seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
                ...(seed.readActiveTurnAdmissionWitness
                    ? { readActiveTurnAdmissionWitness: seed.readActiveTurnAdmissionWitness }
                    : {}),
                requester: Object.freeze({
                    pluginId: seed.plugin.id,
                    contributionId: seed.contribution.id,
                    generationId: seed.generation,
                    invocationId: seed.correlationId,
                }),
                permissionOwner: Object.freeze({
                    kind: 'plugin',
                    pluginId: seed.plugin.id,
                    runtimeId: seed.contribution.qualifiedId,
                }),
            });
            client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
                if (request.params.mode === 'url') return { action: 'decline' as const };
                const requestSignal = composeSignals(lifetimeSignal, extra?.signal);
                if (requestSignal?.aborted || !seed.isGenerationCurrent()) return { action: 'cancel' as const };
                try {
                    const questions = mcpElicitationFormQuestions(request.params.requestedSchema);
                    if (questions === null) {
                        const result = await interactions.confirm({
                            kind: 'confirmation',
                            title: 'MCP request',
                            message: request.params.message,
                        }, {
                            ...(requestSignal ? { signal: requestSignal } : {}),
                        });
                        if (requestSignal?.aborted || !seed.isGenerationCurrent()) return { action: 'cancel' as const };
                        return result.status === 'approved'
                            ? { action: 'accept' as const, content: {} }
                            : result.status === 'declined'
                                ? { action: 'decline' as const }
                                : { action: 'cancel' as const };
                    }
                    const result = await interactions.askQuestions({
                        kind: 'questions',
                        title: request.params.message,
                        questions: [...questions],
                    }, {
                        ...(requestSignal ? { signal: requestSignal } : {}),
                    });
                    if (
                        result.status !== 'answered'
                        || requestSignal?.aborted
                        || !seed.isGenerationCurrent()
                    ) return { action: 'cancel' as const };
                    return {
                        action: 'accept' as const,
                        content: mcpElicitationFormContent(request.params.requestedSchema, result.answers),
                    };
                } catch (error) {
                    if (requestSignal?.aborted || lifetimeSignal?.aborted || !seed.isGenerationCurrent()) {
                        return { action: 'cancel' as const };
                    }
                    throw error;
                }
            });
        }
        try {
            await client.connect(transport, lifetimeSignal ? { signal: lifetimeSignal } : undefined);
        } catch (error) {
            await client.close().catch(() => {});
            release();
            throw error;
        }
        let connectionDisposePromise: Promise<void> | null = null;
        return Object.freeze({
            async listTools(options: Readonly<{
                cursor?: string;
                limit?: number;
                signal?: AbortSignal;
            }> = {}) {
                const result = await client.listTools(
                    options.cursor === undefined ? undefined : { cursor: options.cursor },
                    options.signal ? { signal: options.signal } : undefined,
                );
                return Object.freeze({
                    items: Object.freeze(result.tools.map((tool): PluginMcpTool => Object.freeze({
                        name: tool.name,
                        ...(tool.description === undefined ? {} : { description: tool.description }),
                        inputSchema: toJsonValue(tool.inputSchema) as PluginMcpTool['inputSchema'],
                        ...(tool.outputSchema === undefined ? {} : {
                            outputSchema: toJsonValue(tool.outputSchema) as PluginMcpTool['outputSchema'],
                        }),
                    }))),
                    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
                });
            },
            async callTool(
                name: string,
                input: JsonValue,
                options: Readonly<{ signal?: AbortSignal }> = {},
            ) {
                return toJsonValue(await client.callTool(
                    { name, arguments: input as Readonly<Record<string, unknown>> },
                    undefined,
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            async listResources(options: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                return projectResourcePage(await client.listResources(
                    options.cursor === undefined ? undefined : { cursor: options.cursor },
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            async listResourceTemplates(options: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                return projectResourceTemplatePage(await client.listResourceTemplates(
                    options.cursor === undefined ? undefined : { cursor: options.cursor },
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            async readResource(uri: string, options: Readonly<{ signal?: AbortSignal }> = {}) {
                return projectReadResourceResult(await client.readResource(
                    { uri },
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            async subscribeResource(
                uri: string,
                listener: (event: Readonly<{ uri: string }>) => void | Promise<void>,
                options: Readonly<{ signal?: AbortSignal }> = {},
            ) {
                await client.subscribeResource(
                    { uri },
                    options.signal ? { signal: options.signal } : undefined,
                );
                const subscription: McpResourceSubscriptionRecord = {
                    uri,
                    listener,
                    chain: Promise.resolve(),
                    disposed: false,
                    disposePromise: null,
                    dispose() {
                        if (subscription.disposePromise !== null) return subscription.disposePromise;
                        subscription.disposed = true;
                        subscriptions.delete(subscription);
                        subscription.disposePromise = client.unsubscribeResource({ uri }).then(() => {});
                        return subscription.disposePromise;
                    },
                };
                subscriptions.add(subscription);
                return Object.freeze({ dispose: subscription.dispose });
            },
            async listPrompts(options: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                return projectPromptPage(await client.listPrompts(
                    options.cursor === undefined ? undefined : { cursor: options.cursor },
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            async getPrompt(
                name: string,
                args?: Readonly<Record<string, string>>,
                options: Readonly<{ signal?: AbortSignal }> = {},
            ) {
                return projectGetPromptResult(await client.getPrompt(
                    { name, ...(args === undefined ? {} : { arguments: args }) },
                    options.signal ? { signal: options.signal } : undefined,
                ));
            },
            dispose() {
                if (connectionDisposePromise !== null) return connectionDisposePromise;
                connectionDisposePromise = (async () => {
                    try {
                        await Promise.allSettled([...subscriptions].map((subscription) => subscription.dispose()));
                        await client.close();
                    } finally {
                        release();
                    }
                })();
                return connectionDisposePromise;
            },
        });
    };
}
