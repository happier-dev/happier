export function buildPreflightModelCacheKey(params: Readonly<{
    machineId: string | null;
    agentType: string;
    serverId: string | null;
}>): string | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;
    const serverId = String(params.serverId ?? '').trim() || 'active';
    const agentType = String(params.agentType ?? '').trim();
    return `${serverId}::${machineId}:${agentType}`;
}
