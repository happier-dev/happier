import { parseMcpToolWireNameV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { isDeepStrictEqual } from 'node:util';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return value.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function stringifyShort(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function summarizeArgs(input: UnknownRecord): string {
    const titleCandidate =
        typeof (input as any).title === 'string'
            ? (input as any).title
            : typeof (input as any).name === 'string'
                ? (input as any).name
                : null;
    if (typeof titleCandidate === 'string' && titleCandidate.trim().length > 0) {
        return truncate(titleCandidate.trim(), 140);
    }

    const pathCandidate =
        typeof (input as any).path === 'string'
            ? (input as any).path
            : typeof (input as any).file_path === 'string'
                ? (input as any).file_path
                : typeof (input as any).filePath === 'string'
                    ? (input as any).filePath
                    : null;
    if (typeof pathCandidate === 'string' && pathCandidate.trim().length > 0) {
        return truncate(pathCandidate.trim(), 140);
    }

    const urlCandidate =
        typeof (input as any).url === 'string'
            ? (input as any).url
            : typeof (input as any).href === 'string'
                ? (input as any).href
                : null;
    if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) {
        return truncate(urlCandidate.trim(), 140);
    }

    const queryCandidate = typeof (input as any).query === 'string' ? (input as any).query : null;
    if (typeof queryCandidate === 'string' && queryCandidate.trim().length > 0) {
        return truncate(queryCandidate.trim(), 140);
    }

    const keys = Object.keys(input).filter((k) => !k.startsWith('_')).slice(0, 3);
    if (keys.length === 0) return '';
    const parts = keys.map((k) => `${k}=${truncate(stringifyShort((input as any)[k]), 60)}`);
    return truncate(parts.join(' '), 140);
}

export function parseMcpToolName(toolName: string): { serverId: string; toolId: string } | null {
    const identity = parseMcpToolWireNameV1(toolName);
    return identity ? { serverId: identity.server, toolId: identity.tool } : null;
}

export function normalizeMcpInput(toolName: string, rawInput: unknown): UnknownRecord {
    const parsed = parseMcpToolName(toolName);
    const record = asRecord(rawInput) ?? { value: rawInput };
    if (!parsed) return record;

    const title = `MCP: ${parsed.serverId} ${parsed.toolId}`.replace(/_/g, ' ');
    const subtitle = summarizeArgs(record);

    return {
        ...record,
        _mcp: {
            serverId: parsed.serverId,
            toolId: parsed.toolId,
            display: {
                title,
                subtitle,
            },
        },
    };
}

function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as UnknownRecord;
        if (typeof rec.text === 'string') parts.push(rec.text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function normalizeMcpResult(toolName: string, rawOutput: unknown): UnknownRecord {
    const parsed = parseMcpToolName(toolName);
    const record = asRecord(rawOutput) ?? { value: rawOutput };
    if (!parsed) return record;

    const out: UnknownRecord = { ...record };
    const native = asRecord(record.tool_use_result);
    // Claude may flatten MCP blocks into a string beside the original result.
    // Keep the original blocks in the canonical slot so annotations/media survive.
    if (typeof out.content === 'string' && native && coerceTextFromContentBlocks(native.content) === out.content) {
        out.content = native.content;
    }
    // Preserve the original MCP content, including annotations and non-text blocks.
    // Text previews are a reader projection, not another stored body.
    const text = coerceTextFromContentBlocks(out.content);
    if (typeof out.text === 'string' && (out.text === text || out.text === record.stdout)) delete out.text;
    let parsedContent: unknown;
    if (text !== null && (record.structuredContent != null || native?.structuredContent != null)) {
        try {
            parsedContent = JSON.parse(text);
        } catch {
            // Distinct or non-JSON text and structured facts both remain useful.
        }
    }
    if (record.structuredContent != null && isDeepStrictEqual(parsedContent, record.structuredContent)) delete out.structuredContent;
    if (native) {
        const remaining = Object.fromEntries(Object.entries(native).filter(([key, value]) => {
            if (key === 'structuredContent' && value != null && isDeepStrictEqual(value, parsedContent)) return false;
            if (key === 'text' && typeof value === 'string' && value === text) return false;
            return !Object.hasOwn(out, key) || !isDeepStrictEqual(value, out[key]);
        }));
        if (Object.keys(remaining).length) out.tool_use_result = remaining;
        else delete out.tool_use_result;
    }

    return {
        ...out,
        _mcp: {
            serverId: parsed.serverId,
            toolId: parsed.toolId,
        },
    };
}
