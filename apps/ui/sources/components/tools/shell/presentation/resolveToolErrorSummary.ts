import type { ToolCall } from '@/sync/domains/messages/messageTypes';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstLine(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const newline = trimmed.indexOf('\n');
    return newline >= 0 ? trimmed.slice(0, newline).trim() : trimmed;
}

function stripErrorPrefix(text: string): string {
    return text.replace(/^error:\s*/i, '').trim();
}

export function resolveToolErrorSummary(tool: ToolCall): string | null {
    const result = tool.result;

    const record = asRecord(result);
    if (record) {
        const toolUseResult = record.tool_use_result;
        if (typeof toolUseResult === 'string') {
            const trimmed = toolUseResult.trim();
            if (/^error:/i.test(trimmed)) {
                const stripped = stripErrorPrefix(trimmed);
                return stripped ? firstLine(stripped) : null;
            }
        }

        const error = record.error;
        if (typeof error === 'string' && error.trim()) return firstLine(error);
        const errorRecord = asRecord(error);
        if (errorRecord) {
            const message = errorRecord.message;
            if (typeof message === 'string' && message.trim()) return firstLine(message);
        }

        const message = record.message;
        if (typeof message === 'string' && message.trim()) return firstLine(message);
        const content = record.content;
        if (typeof content === 'string' && content.trim()) return firstLine(content);
    }

    if (typeof result === 'string' && result.trim()) {
        const line = firstLine(result);
        if (/^error:/i.test(line)) return stripErrorPrefix(line) || null;
        return line;
    }

    return null;
}

