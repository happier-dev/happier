import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { maybeParseJson } from '../parse/parseJson';
import { normalizeToolInputForRendering } from '../normalize/inputNormalization';
import { canonicalizeToolNameForRendering } from '../normalize/nameInference';
import { normalizeToolResultForRendering } from '../normalize/resultNormalization';

function inferDescriptionFromInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const raw = (input as Record<string, unknown>).description;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function normalizeToolCallForRendering(tool: ToolCall): ToolCall {
    const parsedInput = maybeParseJson(tool.input);
    const parsedResult = maybeParseJson(tool.result);

    const nextName = canonicalizeToolNameForRendering(tool.name, parsedInput);
    const nextDescription =
        typeof tool.description === 'string' && tool.description.trim().length > 0
            ? tool.description
            : inferDescriptionFromInput(parsedInput);
    const nextInput = normalizeToolInputForRendering({
        toolName: tool.name,
        canonicalToolName: nextName,
        input: parsedInput,
    });
    const nextResult = normalizeToolResultForRendering({ canonicalToolName: nextName, result: parsedResult });

    const nameChanged = nextName !== tool.name;
    const descriptionChanged = nextDescription !== tool.description;
    const inputChanged = nextInput !== tool.input;
    const resultChanged = nextResult !== tool.result;
    if (!nameChanged && !descriptionChanged && !inputChanged && !resultChanged) return tool;
    return { ...tool, name: nextName, description: nextDescription, input: nextInput, result: nextResult };
}
