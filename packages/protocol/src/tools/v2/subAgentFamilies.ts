export const LEGACY_SUBAGENT_TOOL_NAME_ALIASES = ['Task', 'Agent'] as const;

export type LegacySubAgentToolNameAlias = (typeof LEGACY_SUBAGENT_TOOL_NAME_ALIASES)[number];

export const GENERIC_SUBAGENT_TOOL_NAME_ALIASES = ['SubAgent', ...LEGACY_SUBAGENT_TOOL_NAME_ALIASES] as const;

export type GenericSubAgentToolNameAlias = (typeof GENERIC_SUBAGENT_TOOL_NAME_ALIASES)[number];

export function isGenericSubAgentToolName(toolName: string): toolName is GenericSubAgentToolNameAlias {
    return GENERIC_SUBAGENT_TOOL_NAME_ALIASES.includes(toolName as GenericSubAgentToolNameAlias);
}

export function canonicalizeGenericSubAgentToolName(toolName: string): 'SubAgent' | null {
    return isGenericSubAgentToolName(toolName) ? 'SubAgent' : null;
}

export function isSubAgentTranscriptToolName(toolName: string): boolean {
    return toolName === 'SubAgentRun' || isGenericSubAgentToolName(toolName);
}

/**
 * The statuses with which the generic sub-agent tool acknowledges that an agent was *launched*.
 *
 * These are not outcomes. The tool is asynchronous: its result returns within milliseconds carrying
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile }`, the agent then runs for as
 * long as its work takes, and the real outcome arrives separately — routed back by the same
 * tool-use id — as a task notification.
 */
const ASYNC_SUBAGENT_LAUNCH_ACKNOWLEDGEMENT_STATUSES: ReadonlySet<string> = new Set([
    'async_launched',
    'remote_launched',
]);

function readSubAgentToolResultRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const first = trimmed[0];
        if (first !== '{' && first !== '[') return null;
        try {
            return readSubAgentToolResultRecord(JSON.parse(trimmed) as unknown);
        } catch {
            return null;
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Does this tool result merely acknowledge that an agent was launched?
 *
 * The ONE reader for that question, because the agent runtime and the transcript UI must agree on
 * it or the roster tells two stories: workflow correlation must not terminalize an agent at launch,
 * and the transcript derivation must not draw a live agent as finished. Both see the same fact
 * through different envelopes, so the unwrapping lives here too — the transcript normalizer
 * JSON-encodes the raw `toolUseResult` into a string, while the live log converter nests the same
 * object under `tool_use_result`.
 *
 * Tolerant by construction: this shape is undocumented agent-runtime internals, so anything
 * unrecognised answers `false` (the pre-existing reading) rather than throwing or reclassifying a
 * real result.
 */
export function isAsyncSubAgentLaunchToolResult(value: unknown): boolean {
    const record = readSubAgentToolResultRecord(value);
    if (!record) return false;

    const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : null;
    if (status !== null && ASYNC_SUBAGENT_LAUNCH_ACKNOWLEDGEMENT_STATUSES.has(status)) return true;

    return isAsyncSubAgentLaunchToolResult(record.tool_use_result)
        || isAsyncSubAgentLaunchToolResult(record.toolUseResult);
}
