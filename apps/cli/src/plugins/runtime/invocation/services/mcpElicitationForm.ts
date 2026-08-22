import {
    ElicitRequestFormParamsSchema,
    type ElicitRequestFormParams,
} from '@modelcontextprotocol/sdk/types.js';

import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    InteractionTransientAuthorQuestionV1,
    InteractionTransientQuestionAnswerV1,
} from '@happier-dev/protocol';

type McpElicitationChoice = Readonly<{
    id: string;
    label?: string;
    description?: string;
}>;

export type McpElicitationFormSchema = ElicitRequestFormParams['requestedSchema'];

function invalidForm(message: string): PluginError {
    return new PluginError({ code: 'plugin_mcp_elicitation_invalid', message });
}

export function parseMcpElicitationFormSchema(value: unknown): McpElicitationFormSchema {
    const parsed = ElicitRequestFormParamsSchema.safeParse({
        mode: 'form',
        message: 'MCP elicitation',
        requestedSchema: value,
    });
    if (!parsed.success) throw invalidForm('MCP elicitation schema is invalid');
    return parsed.data.requestedSchema;
}

function choicesForProperty(property: Readonly<Record<string, unknown>>): readonly McpElicitationChoice[] {
    if (Array.isArray(property.enum)) {
        const values = property.enum.filter((value): value is string => typeof value === 'string');
        const labels = Array.isArray(property.enumNames)
            ? property.enumNames.filter((value): value is string => typeof value === 'string')
            : [];
        return values.map((value, index) => Object.freeze({ id: value, label: labels[index] ?? value }));
    }
    if (Array.isArray(property.oneOf)) {
        return property.oneOf.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const item = value as Readonly<Record<string, unknown>>;
            return typeof item.const === 'string'
                ? [Object.freeze({
                    id: item.const,
                    label: typeof item.title === 'string' ? item.title : item.const,
                })]
                : [];
        });
    }
    return [];
}

function arrayItemChoices(property: Readonly<Record<string, unknown>>): readonly McpElicitationChoice[] {
    if (!property.items || typeof property.items !== 'object' || Array.isArray(property.items)) return [];
    const items = property.items as Readonly<Record<string, unknown>>;
    if (Array.isArray(items.anyOf)) {
        return items.anyOf.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const item = value as Readonly<Record<string, unknown>>;
            return typeof item.const === 'string'
                ? [Object.freeze({
                    id: item.const,
                    label: typeof item.title === 'string' ? item.title : item.const,
                })]
                : [];
        });
    }
    return choicesForProperty(items);
}

function nonEmptyChoices(
    choices: readonly McpElicitationChoice[],
): [McpElicitationChoice, ...McpElicitationChoice[]] {
    if (choices.length === 0) throw invalidForm('MCP elicitation selection has no choices');
    return [...choices] as [McpElicitationChoice, ...McpElicitationChoice[]];
}

export function mcpElicitationFormQuestions(
    schema: McpElicitationFormSchema,
): readonly [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]] | null {
    const required = new Set(schema.required ?? []);
    const questions = Object.entries(schema.properties).map(([id, rawProperty]): InteractionTransientAuthorQuestionV1 => {
        const property = rawProperty as Readonly<Record<string, unknown>>;
        const prompt = typeof property.title === 'string'
            ? property.title
            : typeof property.description === 'string'
                ? property.description
                : id;
        if (property.type === 'array') {
            return Object.freeze({
                id, prompt, type: 'multipleChoice' as const, required: required.has(id),
                choices: nonEmptyChoices(arrayItemChoices(property)),
            });
        }
        if (property.type === 'boolean') {
            return Object.freeze({
                id, prompt, type: 'singleChoice' as const, required: required.has(id),
                choices: nonEmptyChoices(Object.freeze([
                    Object.freeze({ id: 'true', label: 'true' }),
                    Object.freeze({ id: 'false', label: 'false' }),
                ])),
            });
        }
        const choices = choicesForProperty(property);
        if (choices.length > 0) {
            return Object.freeze({
                id, prompt, type: 'singleChoice' as const, required: required.has(id),
                choices: nonEmptyChoices(choices),
            });
        }
        return Object.freeze({ id, prompt, type: 'text' as const, required: required.has(id) });
    });
    return questions.length === 0
        ? null
        : questions as [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]];
}

function selectedValue(answer: InteractionTransientQuestionAnswerV1): string {
    if (answer.kind === 'text') return answer.value;
    if (answer.kind === 'singleChoice') {
        return answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value;
    }
    throw invalidForm('MCP elicitation answer is not scalar');
}

function answerValue(
    answer: InteractionTransientQuestionAnswerV1,
    property: Readonly<Record<string, unknown>>,
): JsonValue {
    if (property.type === 'array') {
        if (answer.kind !== 'multipleChoice') throw invalidForm('MCP elicitation answer is not a list');
        return answer.answers.map((entry) => entry.kind === 'choice' ? entry.choiceId : entry.value);
    }
    const value = selectedValue(answer);
    if (property.type === 'number' || property.type === 'integer') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || (property.type === 'integer' && !Number.isInteger(parsed))) {
            throw invalidForm('MCP elicitation answer is not a valid number');
        }
        return parsed;
    }
    if (property.type === 'boolean') {
        if (value !== 'true' && value !== 'false') {
            throw invalidForm('MCP elicitation answer is not a valid boolean');
        }
        return value === 'true';
    }
    return value;
}

export function mcpElicitationFormContent(
    schema: McpElicitationFormSchema,
    answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>,
): Readonly<Record<string, JsonValue>> {
    const content = Object.create(null) as Record<string, JsonValue>;
    for (const [id, answer] of Object.entries(answers)) {
        const property = schema.properties[id];
        if (property) content[id] = answerValue(answer, property as Readonly<Record<string, unknown>>);
    }
    return Object.freeze(content);
}
