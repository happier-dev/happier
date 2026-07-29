import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginMcpClient, PluginMcpTool, PluginUiQuestion, PluginUiQuestionAnswer } from '@happier-dev/plugin-sdk/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginInvocationUi } from './ui';
import type { DeclaredTransportConnector } from './mcp';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/runtime';

type ResolvedMcpExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release?: () => void;
}>;

function toJsonValue(value: unknown): JsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new PluginError({ code: 'plugin_mcp_result_invalid', message: 'MCP result is not JSON serializable' });
    }
    return JSON.parse(encoded) as JsonValue;
}

function formQuestions(schema: Readonly<{
    properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    required?: readonly string[];
}>): readonly [PluginUiQuestion, ...PluginUiQuestion[]] | null {
    const required = new Set(schema.required ?? []);
    const questions = Object.entries(schema.properties).map(([id, property]): PluginUiQuestion => {
        const prompt = typeof property.title === 'string'
            ? property.title
            : typeof property.description === 'string'
                ? property.description
                : id;
        const enumValues = Array.isArray(property.enum)
            ? property.enum.filter((value): value is string => typeof value === 'string')
            : [];
        const oneOfValues = Array.isArray(property.oneOf)
            ? property.oneOf.flatMap((value) => (
                value && typeof value === 'object' && !Array.isArray(value)
                && typeof (value as Readonly<Record<string, unknown>>).const === 'string'
                    ? [(value as Readonly<Record<string, unknown>>).const as string]
                    : []
            ))
            : [];
        const values = enumValues.length > 0 ? enumValues : oneOfValues;
        const items = property.items && typeof property.items === 'object' && !Array.isArray(property.items)
            ? property.items as Readonly<Record<string, unknown>>
            : null;
        const arrayValues = items && Array.isArray(items.enum)
            ? items.enum.filter((value): value is string => typeof value === 'string')
            : [];
        if (property.type === 'array' && arrayValues.length > 0) {
            return Object.freeze({
                id, prompt, type: 'multiple' as const, required: required.has(id),
                choices: arrayValues.map((value) => Object.freeze({ id: value, label: value })) as [
                    { id: string; label: string }, ...{ id: string; label: string }[],
                ],
            });
        }
        if (property.type === 'boolean' || values.length > 0) {
            const choices = property.type === 'boolean' ? ['true', 'false'] : values;
            return Object.freeze({
                id, prompt, type: 'single' as const, required: required.has(id),
                choices: choices.map((value) => Object.freeze({ id: value, label: value })) as [
                    { id: string; label: string }, ...{ id: string; label: string }[],
                ],
            });
        }
        return Object.freeze({ id, prompt, type: 'text' as const, required: required.has(id) });
    });
    return questions.length === 0
        ? null
        : questions as [PluginUiQuestion, ...PluginUiQuestion[]];
}

function answerValue(answer: PluginUiQuestionAnswer, property: Readonly<Record<string, unknown>>): JsonValue {
    if (answer.type === 'text') {
        if (property.type === 'number' || property.type === 'integer') {
            const parsed = Number(answer.value);
            if (!Number.isFinite(parsed) || (property.type === 'integer' && !Number.isInteger(parsed))) {
                throw new PluginError({ code: 'plugin_mcp_elicitation_invalid', message: 'MCP elicitation answer is not a valid number' });
            }
            return parsed;
        }
        return answer.value;
    }
    if (answer.type === 'single') {
        const value = answer.answer.type === 'choice' ? answer.answer.choiceId : answer.answer.value;
        return property.type === 'boolean' ? value === 'true' : value;
    }
    return answer.answers.map((entry) => entry.type === 'choice' ? entry.choiceId : entry.value);
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
        const client = new Client(
            { name: 'happier-plugin-mcp', version: '1.0.0' },
            { capabilities: elicitation.mode === 'hostMediated' ? { elicitation: { form: {} } } : {} },
        );
        if (elicitation.mode === 'hostMediated') {
            const ui = createPluginInvocationUi({
                currentSession: seed.currentSession ?? null,
                signal: signal ?? seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            });
            client.setRequestHandler(ElicitRequestSchema, async (request) => {
                if (request.params.mode === 'url') return { action: 'decline' as const };
                const questions = formQuestions(request.params.requestedSchema);
                if (questions === null) {
                    const accepted = await ui.confirm(request.params.message, { title: 'MCP request' });
                    return { action: accepted ? 'accept' as const : 'decline' as const, ...(accepted ? { content: {} } : {}) };
                }
                const result = await ui.askQuestions(questions, { title: request.params.message });
                if (result.status !== 'answered') return { action: 'cancel' as const };
                const content: Record<string, JsonValue> = {};
                for (const [id, answer] of Object.entries(result.answers)) {
                    const property = request.params.requestedSchema.properties[id];
                    if (property) content[id] = answerValue(answer, property);
                }
                return { action: 'accept' as const, content };
            });
        }
        try {
            await client.connect(transport, signal ? { signal } : undefined);
        } catch (error) {
            await client.close().catch(() => {});
            release();
            throw error;
        }
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
            async dispose() {
                try {
                    await client.close();
                } finally {
                    release();
                }
            },
        });
    };
}
