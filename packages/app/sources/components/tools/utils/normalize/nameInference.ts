import { asRecord, firstNonEmptyString, hasNonEmptyRecord } from './_shared';

function canonicalizeToolNameNonV2(toolName: string, input: unknown): string {
    // NOTE: This path covers:
    // - legacy sessions (pre V2 tool normalization)
    // - Claude local-control sessions (tool events produced from a transcript; no `_happy` metadata)

    const inputObj = asRecord(input);

    if (toolName === 'CodexPatch' || toolName === 'GeminiPatch') return 'Patch';
    if (toolName === 'CodexDiff' || toolName === 'GeminiDiff') return 'Diff';
    if (toolName === 'CodexReasoning' || toolName === 'GeminiReasoning' || toolName === 'think') return 'Reasoning';
    if (toolName === 'exit_plan_mode') return 'ExitPlanMode';

    if (toolName === 'mcp__happy__change_title') return 'change_title';

    const lower = toolName.toLowerCase();
    if (lower === 'patch') return 'Patch';
    if (lower === 'diff') return 'Diff';
    if (
        lower === 'execute' ||
        lower === 'shell' ||
        lower === 'bash' ||
        toolName === 'GeminiBash' ||
        toolName === 'CodexBash'
    ) {
        return 'Bash';
    }
    if (lower === 'read' || lower === 'read_file' || lower === 'readfile') return 'Read';
    if (lower === 'delete' || lower === 'remove') {
        const changes = asRecord(inputObj?.changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        return 'Delete';
    }
    if (lower === 'edit') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'edit_file' || lower === 'editfile') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'write') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }
    if (lower === 'write_file' || lower === 'writefile') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }

    if (lower === 'glob') return 'Glob';
    if (lower === 'grep') return 'Grep';
    if (lower === 'ls') return 'LS';
    if (lower === 'web_fetch' || lower === 'webfetch') return 'WebFetch';
    if (lower === 'web_search' || lower === 'websearch') return 'WebSearch';

    if (lower === 'search') {
        const hasQuery =
            !!firstNonEmptyString(inputObj?.query) ||
            !!firstNonEmptyString(inputObj?.pattern) ||
            !!firstNonEmptyString(inputObj?.text);
        // Gemini internal "search" often has only items/locations and is intentionally minimal/hidden.
        return hasQuery ? 'CodeSearch' : toolName;
    }

    if (lower === 'unknown tool') {
        const title =
            firstNonEmptyString(inputObj?.title) ??
            firstNonEmptyString(asRecord(inputObj?.toolCall)?.title) ??
            null;
        if (title === 'Workspace Indexing Permission') return 'WorkspaceIndexingPermission';
    }

    return toolName;
}

export function canonicalizeToolNameForRendering(toolName: string, input: unknown): string {
    const inputObj = asRecord(input);
    const happy = asRecord(asRecord(inputObj)?._happy);
    const canonicalFromHappy = firstNonEmptyString(happy?.canonicalToolName);
    if (canonicalFromHappy) return canonicalFromHappy;
    return canonicalizeToolNameNonV2(toolName, input);
}

