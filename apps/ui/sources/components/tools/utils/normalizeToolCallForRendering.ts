import type { ToolCall } from '@/sync/typesMessage';
import { maybeParseJson } from './parseJson';
import { normalizeToolInputForRendering } from './normalize/inputNormalization';
import { canonicalizeToolNameForRendering } from './normalize/nameInference';
import { normalizeToolResultForRendering } from './normalize/resultNormalization';

export function normalizeToolCallForRendering(tool: ToolCall): ToolCall {
    const parsedInput = maybeParseJson(tool.input);
    const parsedResult = maybeParseJson(tool.result);

    const nextName = canonicalizeToolNameForRendering(tool.name, parsedInput);
    const nextInput = normalizeToolInputForRendering({
        toolName: tool.name,
        canonicalToolName: nextName,
        input: parsedInput,
    });
    const nextResult = normalizeToolResultForRendering({ canonicalToolName: nextName, result: parsedResult });

    const nameChanged = nextName !== tool.name;
    const inputChanged = nextInput !== tool.input;
    const resultChanged = nextResult !== tool.result;
    if (!nameChanged && !inputChanged && !resultChanged) return tool;
    return { ...tool, name: nextName, input: nextInput, result: nextResult };
}
