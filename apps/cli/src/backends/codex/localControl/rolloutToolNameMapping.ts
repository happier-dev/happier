export type CodexRolloutToolVisibility = 'default' | 'debug-only' | 'ignore';

/**
 * Inventory of Codex rollout tool names observed in real `~/.codex/sessions` rollouts (2026).
 *
 * Notes:
 * - `mcp__*` tools are treated as pass-through via prefix matching; we don't attempt to enumerate every possible MCP tool.
 * - This list is used for drift detection + tests. When Codex introduces a new *non-mcp* tool name, we want tests to fail loudly.
 */
export const KNOWN_CODEX_ROLLOUT_TOOL_NAMES = [
    // function_call (legacy aliases)
    'shell',
    'shell_command',
    // function_call
    'exec_command',
    // function_call (legacy context7 aliases)
    'context7__get-library-docs',
    'context7__resolve-library-id',
    'update_plan',
    'write_stdin',
    'view_image',
    'request_user_input',
    'read_mcp_resource',
    'list_mcp_resources',
    'list_mcp_resource_templates',
    // custom_tool_call
    'apply_patch',
] as const;

export type KnownCodexRolloutToolName = (typeof KNOWN_CODEX_ROLLOUT_TOOL_NAMES)[number];

export function canonicalizeCodexRolloutToolName(name: string): {
    canonicalToolName: string;
    visibility: CodexRolloutToolVisibility;
} {
    if (name.startsWith('mcp__')) {
        return { canonicalToolName: name, visibility: 'default' };
    }

    switch (name) {
        case 'shell':
        case 'shell_command':
        case 'exec_command':
            return { canonicalToolName: 'Bash', visibility: 'default' };
        case 'apply_patch':
            return { canonicalToolName: 'Patch', visibility: 'default' };
        case 'context7__get-library-docs':
            return { canonicalToolName: 'mcp__context7__get-library-docs', visibility: 'default' };
        case 'context7__resolve-library-id':
            return { canonicalToolName: 'mcp__context7__resolve-library-id', visibility: 'default' };

        // Agent-internal tools (not very useful as primary UI cards in local-control mirroring).
        case 'update_plan':
        case 'view_image':
        case 'request_user_input':
        case 'read_mcp_resource':
        case 'list_mcp_resources':
        case 'list_mcp_resource_templates':
            return { canonicalToolName: name, visibility: 'debug-only' };

        // UI plumbing.
        case 'write_stdin':
            return { canonicalToolName: name, visibility: 'ignore' };
    }

    return { canonicalToolName: name, visibility: 'debug-only' };
}

function safeJsonParse(value: string): unknown | null {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

/**
 * Best-effort normalization of Codex rollout tool inputs.
 *
 * This is intentionally conservative: it aims to give the V2 normalization layer enough shape
 * to render a useful card, while always preserving `_raw` at the tool normalization layer.
 */
export function normalizeCodexRolloutToolInput(name: string, rawInput: unknown): unknown {
    if (typeof rawInput === 'string') {
        const parsed = safeJsonParse(rawInput);
        if (parsed != null) return normalizeCodexRolloutToolInput(name, parsed);
    }

    if (name === 'apply_patch') {
        // Codex rollouts store the patch as a single string (custom_tool_call.input).
        if (typeof rawInput === 'string') return { patch: rawInput };
        if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) return rawInput;
        return { patch: String(rawInput) };
    }

    // exec_command.arguments is a JSON string that typically contains { cmd, yield_time_ms, ... }.
    // V2 Bash normalizer understands `cmd`.
    return rawInput;
}
