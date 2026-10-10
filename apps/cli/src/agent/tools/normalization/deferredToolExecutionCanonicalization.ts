type UnknownRecord = Record<string, unknown>;

// CodeBuddy Code 2.162 loads MCP tools lazily: `ToolSearch` resolves them and the call itself is an
// ACP `other` tool titled `DeferExecuteTool` with input `{ toolName, params }`.
const DEFERRED_TOOL_EXECUTION_WRAPPER_TITLES = new Set(['deferexecutetool']);

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function isDeferredToolExecutionWrapper(record: UnknownRecord): boolean {
    const acp = asRecord(record._acp);
    return [record.title, record.description, acp?.title].some(
        (value) => typeof value === 'string' && DEFERRED_TOOL_EXECUTION_WRAPPER_TITLES.has(value.trim().toLowerCase()),
    );
}

export function extractDeferredToolExecutionCall(rawInput: unknown): { toolName: string; params: UnknownRecord } | null {
    const record = asRecord(rawInput);
    if (!record || !isDeferredToolExecutionWrapper(record)) return null;
    const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
    if (!toolName) return null;
    return { toolName, params: asRecord(record.params) ?? {} };
}
