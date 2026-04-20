/**
 * RU-02: `customAcp` is compatibility-only.
 *
 * UI code should not treat `customAcp` as a canonical agent id. This module exists
 * as an explicit compat boundary for older persisted/ingress carriers and for
 * test seams that still mock legacy behavior.
 */

export const LEGACY_CUSTOM_ACP_AGENT_ID = 'customAcp' as const;
export type LegacyCustomAcpAgentId = typeof LEGACY_CUSTOM_ACP_AGENT_ID;

export type AgentLookupCoreConfig = Readonly<Record<string, unknown>>;

export function resolveAgentLookupCoreConfig(_agentId?: string | null): AgentLookupCoreConfig | null {
    return null;
}
