import type { ToolCall } from "../messages/index.js";
import { readHappierActionToolFailure } from '@happier-dev/protocol/actions/happierActionToolResult';

export type ToolStatusIndicatorKind =
    | 'permission_blocked'
    | 'permission_pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'none';

/** How the person answered the Action approval that belongs to this call, when they declined it. */
export type DeclinedApprovalDisposition = 'rejected' | 'canceled';

const resultFailureByResultRoot = new WeakMap<object, boolean>();

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
    if (!result || typeof result !== 'object') {
        return hasStructuredResultFailure(result);
    }

    const cached = resultFailureByResultRoot.get(result);
    if (cached !== undefined) return cached;

    let hasFailure = false;
    if (!Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        const toolUseResult = record.tool_use_result;
        hasFailure = typeof toolUseResult === 'string'
            && toolUseResult.trim().toLowerCase().startsWith('error:');
    }
    if (!hasFailure) hasFailure = hasStructuredResultFailure(result);
    if (!hasFailure) hasFailure = readHappierActionToolFailure(tool.name, tool.input, result) !== null;

    // Published tool results are immutable projections: updates replace the result root.
    // Keying that root avoids reparsing unchanged output while letting obsolete payloads be collected.
    resultFailureByResultRoot.set(result, hasFailure);
    return hasFailure;
}

/**
 * `declinedApproval` is the matched approval's disposition (the approval is a separate artifact, not part
 * of the call): a call the person declined reads as blocked, never as a completed success. A real
 * execution failure still reads as an error.
 */
export function resolveToolStatusIndicatorKind(
    tool: ToolCall,
    declinedApproval: DeclinedApprovalDisposition | null = null,
): ToolStatusIndicatorKind {
    const permissionStatus = tool.permission?.status;
    if (permissionStatus === 'denied' || permissionStatus === 'canceled') return 'permission_blocked';
    if (permissionStatus === 'pending' && tool.state === 'running') return 'permission_pending';

    if (tool.state === 'running') return 'running';
    if (tool.state === 'error') return 'error';
    if (tool.state === 'unavailable') {
        return hasToolResultFailure(tool) ? 'error' : 'none';
    }
    if (tool.state === 'completed') {
        if (hasToolResultFailure(tool)) return 'error';
        // Public recipients do not receive owner AgentState. A native command's
        // terminal decline is carried in the copied result, not an execution error.
        const result: unknown = tool.result;
        const commandDeclined = result !== null && typeof result === 'object' && !Array.isArray(result)
            && 'type' in result && result.type === 'commandExecution'
            && 'status' in result && result.status === 'declined';
        return declinedApproval || commandDeclined ? 'permission_blocked' : 'completed';
    }
    return 'none';
}
