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
