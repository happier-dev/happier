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
    if (!toolName.startsWith('mcp__')) return null;
    const withoutPrefix = toolName.replace(/^mcp__/, '');
    const parts = withoutPrefix.split('__').filter((p) => p.length > 0);
    if (parts.length < 2) return null;
    const serverId = parts[0];
    const toolId = parts.slice(1).join('__');
    return { serverId, toolId };
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
    // Common MCP-style output: { content: [{type:'text',text:'...'}], isError: boolean }
    const text = coerceTextFromContentBlocks((record as any).content);
    if (text && typeof out.text !== 'string') out.text = text;

    return {
        ...out,
        _mcp: {
            serverId: parsed.serverId,
            toolId: parsed.toolId,
        },
    };
}

