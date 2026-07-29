export function createPluginAgentSettingsRoute(agentId: string): string {
    return `/(app)/settings/agents/${encodeURIComponent(agentId)}`;
}
