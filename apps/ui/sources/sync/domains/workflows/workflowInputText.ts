import type { JsonValue } from '@happier-dev/protocol';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

/**
 * A declared input's value as a person types it, and back: the Run review and a trigger set's
 * constant inputs ("Same for all triggers") read and write values the same way.
 */
export type WorkflowInputTextDraft = Readonly<{
    value: JsonValue | undefined;
    invalid: boolean;
}>;

/** Raw editor buffers and semantic JSON strings are distinct at the input owner. */
export function parseWorkflowInputTextDraft(definition: WorkflowInputDefinition, text: string): WorkflowInputTextDraft {
    if (text.length === 0) return { value: undefined, invalid: false };
    switch (definition.valueType) {
        case 'string':
            return { value: text, invalid: false };
        case 'number': {
            const parsed = Number(text);
            return Number.isFinite(parsed) ? { value: parsed, invalid: false } : { value: undefined, invalid: true };
        }
        case 'boolean': {
            const normalized = text.trim().toLowerCase();
            if (normalized === 'true') return { value: true, invalid: false };
            if (normalized === 'false') return { value: false, invalid: false };
            return { value: undefined, invalid: true };
        }
        case 'json':
            try {
                const parsed = StrictJsonValueSchema.safeParse(JSON.parse(text));
                return parsed.success ? { value: parsed.data, invalid: false } : { value: undefined, invalid: true };
            } catch {
                return { value: undefined, invalid: true };
            }
    }
}

export function parseWorkflowInputText(definition: WorkflowInputDefinition, text: string): JsonValue | undefined {
    const draft = parseWorkflowInputTextDraft(definition, text);
    return draft.invalid ? text : draft.value;
}

export function formatWorkflowInputValue(value: JsonValue | undefined): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}
