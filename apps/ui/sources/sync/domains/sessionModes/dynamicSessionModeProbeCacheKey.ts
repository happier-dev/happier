export function buildDynamicSessionModeProbeCacheKey(params: Readonly<{
    machineId: string | null;
    agentType: string;
    serverId: string | null;
    cwd?: string | null;
}>): string | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;
    const serverId = String(params.serverId ?? '').trim() || 'active';
    const agentType = String(params.agentType ?? '').trim();
    const cwd = String(params.cwd ?? '').trim();
    // JSON encoding avoids delimiter collisions (e.g. `cwd` containing `:` or `::`).
    return JSON.stringify(['dynamicSessionModeProbe', serverId, machineId, agentType, cwd]);
}

