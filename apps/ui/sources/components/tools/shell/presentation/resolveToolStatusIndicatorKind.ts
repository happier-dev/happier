import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export type ToolStatusIndicatorKind =
    | 'permission_blocked'
    | 'permission_pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'none';

function parseStructuredResultText(value: string): unknown | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
        if (!firstLine || firstLine === trimmed) return null;
        try {
            return JSON.parse(firstLine) as unknown;
        } catch {
            return null;
        }
    }
}

function isHappierToolsCallEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 && record.kind === 'tools_call';
}

function hasStructuredResultFailure(value: unknown, depth = 0): boolean {
    if (depth > 5) return false;
    if (typeof value === 'string') {
        const parsed = parseStructuredResultText(value);
        return isHappierToolsCallEnvelope(parsed) && hasStructuredResultFailure(parsed, depth + 1);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    const record = value as Record<string, unknown>;
    if (record.ok === false || record.isError === true) return true;

    if (Array.isArray(record.results)) {
        for (const result of record.results) {
            if (hasStructuredResultFailure(result, depth + 1)) return true;
        }
    }

    for (const key of ['data', 'output', 'result', 'stdout'] as const) {
        if (hasStructuredResultFailure(record[key], depth + 1)) return true;
    }

    const content = record.content;
    if (typeof content === 'string' && hasStructuredResultFailure(content, depth + 1)) return true;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
            const blockRecord = block as Record<string, unknown>;
            if (blockRecord.type === 'text' && hasStructuredResultFailure(blockRecord.text, depth + 1)) return true;
        }
    }

    return false;
}

function hasToolResultFailure(tool: ToolCall): boolean {
    const result = tool.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return hasStructuredResultFailure(result);
    }
    const record = result as Record<string, unknown>;
    const toolUseResult = record.tool_use_result;
    if (typeof toolUseResult === 'string' && toolUseResult.trim().toLowerCase().startsWith('error:')) {
        return true;
    }
    return hasStructuredResultFailure(result);
}

export function resolveToolStatusIndicatorKind(tool: ToolCall): ToolStatusIndicatorKind {
    const permissionStatus = tool.permission?.status;
    if (permissionStatus === 'denied' || permissionStatus === 'canceled') return 'permission_blocked';
    if (permissionStatus === 'pending' && tool.state === 'running') return 'permission_pending';

    if (tool.state === 'running') return 'running';
    if (tool.state === 'error') return 'error';
    if (tool.state === 'unavailable') {
        return hasToolResultFailure(tool) ? 'error' : 'none';
    }
    if (tool.state === 'completed') {
        return hasToolResultFailure(tool) ? 'error' : 'completed';
    }
    return 'none';
}
